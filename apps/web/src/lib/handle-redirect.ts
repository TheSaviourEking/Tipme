import { isReservedHandle, normaliseHandle } from '@tipme/domain';

// Renamed handles (PR-011): an old link or printed QR code goes to the page's current address.
// Only the QR marker travels with it, so a redirect never carries anything else forward.
export function movedProfilePath(
  handle: string,
  query: Record<string, string | string[] | undefined>,
): string {
  return `/@${handle}${query['src'] === 'qr' ? '?src=qr' : ''}`;
}

/**
 * Short links: /ada (any case) leads to the canonical /@ada. Only a single path segment that is a
 * valid, unreserved handle qualifies; every single-word TipMe page is a reserved handle
 * (test/short-links.test.mjs), so this never shadows a real page.
 */
export function shortLinkTarget(
  pathname: string,
  search: URLSearchParams,
): string | null {
  const match = /^\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  let segment: string;
  try {
    segment = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const handle = normaliseHandle(segment);
  if (!handle || isReservedHandle(handle)) return null;
  return movedProfilePath(handle, {
    src:
      search.getAll('src').length === 1
        ? (search.get('src') ?? undefined)
        : undefined,
  });
}
