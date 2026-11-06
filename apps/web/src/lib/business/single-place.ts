// The business page with one open place sends people straight to that place (BusinessProfile
// board, approved 6 Nov 2026). It is decided in Proxy, before the page streams, so the answer is a
// real temporary redirect (307): it stops by itself the day a second place opens.

/** What the API's `GET /v1/b/<business>` answered: its status and JSON body. */
export type BusinessLookup = (
  slug: string,
) => Promise<{ status: number; body: unknown }>;

const BUSINESS_PAGE =
  /^\/b\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?)\/?$/;
const LOCATION_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
/** As long as the page's own cached copy may be stale (public-api.ts). */
const REMEMBER_MS = 30_000;
const MAX_REMEMBERED = 500;

function onlyPlace(body: unknown): string | null {
  const locations = (body as { data?: { locations?: unknown } } | null)?.data
    ?.locations;
  if (!Array.isArray(locations) || locations.length !== 1) return null;
  const slug = (locations[0] as { slug?: unknown } | null)?.slug;
  return typeof slug === 'string' && LOCATION_SLUG.test(slug) ? slug : null;
}

/**
 * `(pathname, searchParams)` → the one place's path, or null to render the page as usual (two or
 * more places, not taking tips, unknown, or the API out of reach: the page decides those).
 */
export function createSinglePlaceRedirect(
  lookup: BusinessLookup,
  clock: () => number = Date.now,
) {
  const remembered = new Map<string, { at: number; place: string | null }>();
  return async function target(
    pathname: string,
    searchParams: URLSearchParams,
  ): Promise<string | null> {
    const match = BUSINESS_PAGE.exec(pathname);
    if (!match) return null;
    const slug = match[1]!.toLowerCase();
    const now = clock();
    let entry = remembered.get(slug);
    if (!entry || now - entry.at >= REMEMBER_MS) {
      let place: string | null = null;
      try {
        const answer = await lookup(slug);
        place = answer.status === 200 ? onlyPlace(answer.body) : null;
      } catch {
        // Out of reach: the page shows its own retry.
        return null;
      }
      if (remembered.size >= MAX_REMEMBERED) remembered.clear();
      entry = { at: now, place };
      remembered.set(slug, entry);
    }
    if (!entry.place) return null;
    const path = `/b/${slug}/${entry.place}`;
    return searchParams.get('src') === 'qr' ? `${path}?src=qr` : path;
  };
}
