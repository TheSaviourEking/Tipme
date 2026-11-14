import { avatarSource } from '@/lib/avatar-source';

// The photo on a person's share card (owner, 14 Nov 2026: their photo when they have one, initials
// when not). next/og refuses image URLs on private addresses, and the API is often one, so the
// photo is fetched here and handed to the card as a data URL. Any failure (no photo, a slow or
// failing API, something that is not a picture) answers null, and the card draws the initials:
// a share card never breaks over a photo.
//
// next/og draws PNG, JPEG and SVG but leaves a WebP blank, and uploaded photos are WebP. The API
// serves each one as a small PNG too (`/v1/avatars/<page>/<n>.png`, the same privacy rules), so
// that is what is fetched. The web app itself never decodes images (scripts/web-bundle.test.mjs
// keeps image libraries out of it). The WebP demo portraits have no PNG: their cards show initials.

/** Short: a link preview waits on this before it draws. */
export const SHARE_PHOTO_TIMEOUT_MS = 1500;
/** The API's PNG is 304 × 304; anything far larger is not one. */
const MAX_BYTES = 2_000_000;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);

export async function shareCardPhoto(
  path: string | null | undefined,
  options: {
    /** The API as the web server reaches it. */
    apiOrigin: string;
    /** This site, for the demo pictures it serves itself. */
    siteOrigin: string;
    /** Sent to the API only (the preview server key on staging). */
    headers?: Record<string, string>;
    fetch?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<string | null> {
  // The same rule as the page's picture: an uploaded photo or a demo picture, nothing else.
  const source = path ? avatarSource(path, '', options.apiOrigin) : null;
  if (!source) return null;
  const url = new URL(source.src, options.siteOrigin);
  const fromApi = url.origin === new URL(options.apiOrigin).origin;
  if (fromApi) url.pathname = url.pathname.replace(/\.webp$/, '.png');
  else if (url.pathname.endsWith('.webp')) return null;
  try {
    const response = await (options.fetch ?? fetch)(url.href, {
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? SHARE_PHOTO_TIMEOUT_MS),
      headers: fromApi ? { ...options.headers } : {},
    });
    const type = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (!response.ok || !type || !TYPES.has(type)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    // Nothing personal is logged; the card falls back to the initials.
    return null;
  }
}
