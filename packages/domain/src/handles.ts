/**
 * Recipient handles (`/@handle`). Lower-case letters, digits and underscores, 3–30 long, unique
 * without regard to case. Words that would clash with TipMe's own pages are reserved, including
 * ones TipMe may want later: `/handle` also leads to a page, so a single-word route must not
 * belong to anyone (apps/web/test/short-links.test.mjs checks the routes that exist today).
 */
const HANDLE = /^[a-z0-9_]{3,30}$/;

export const RESERVED_HANDLES = [
  '_next',
  'about',
  'about_preview',
  'account',
  'admin',
  'api',
  'app',
  'avatars',
  'blog',
  'brand',
  'business',
  'careers',
  'contact',
  'dashboard',
  'design_system',
  'dev',
  'download',
  'explore',
  'faq',
  'favicon',
  'for_creators',
  'for_professionals',
  'help',
  'home',
  'how_it_works',
  'icon',
  'illustrations',
  'jobs',
  'legal',
  'login',
  'logout',
  'me',
  'mock_checkout',
  'ops',
  'partners',
  'pay',
  'payments',
  'people',
  'portraits',
  'press',
  'preview_states',
  'pricing',
  'privacy',
  'profile',
  'qr',
  'recover',
  'register',
  'robots',
  'root',
  'search',
  'security',
  'settings',
  'shop',
  'sign_in',
  'sign_up',
  'signin',
  'signup',
  'sitemap',
  'staff',
  'status',
  'support',
  'team',
  'terms',
  'tip',
  'tipme',
  'tips',
  'verify',
  'wallet',
  'www',
] as const;
const reserved: ReadonlySet<string> = new Set(RESERVED_HANDLES);

/** The canonical form of a handle, or null when it can never be a handle. */
export function normaliseHandle(raw: string): string | null {
  const handle = raw.trim().toLowerCase();
  return HANDLE.test(handle) ? handle : null;
}

export function isReservedHandle(handle: string): boolean {
  return reserved.has(handle.toLowerCase().replaceAll('-', '_'));
}
