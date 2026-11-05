/**
 * Recipient handles (`/@handle`). Lower-case letters, digits and underscores, 3–30 long, unique
 * without regard to case. Words that would clash with TipMe's own pages are reserved, including
 * ones TipMe may want later: `/handle` also leads to a page, so a single-word route must not
 * belong to anyone (apps/web/test/short-links.test.mjs checks the routes that exist today).
 * The example people on TipMe's own pages are reserved too (apps/web/test/example-handles.test.mjs),
 * so a printed address never leads to a stranger's page. The seeded demo pages ada and tobi are
 * inserted directly and keep working; a reserved handle that already exists is not removed.
 */
const HANDLE = /^[a-z0-9_]{3,30}$/;

export const RESERVED_HANDLES = [
  '_next',
  'about',
  'about_preview',
  'account',
  'ada',
  'adacuts',
  'adaedits',
  'adaokafor',
  'admin',
  'api',
  'app',
  'avatars',
  'blog',
  'brand',
  'business',
  'careers',
  'contact',
  'covers',
  'dashboard',
  'design_system',
  'dev',
  'download',
  'email',
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
  'pro',
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
  'sounds',
  'staff',
  'status',
  'support',
  'team',
  'terms',
  'tip',
  'tipme',
  'tips',
  'tobi',
  'verify',
  'wallet',
  'www',
  'zainab',
] as const;
const reserved: ReadonlySet<string> = new Set(RESERVED_HANDLES);

/** The canonical form of a handle, or null when it can never be a handle. */
export function normaliseHandle(raw: string): string | null {
  const handle = raw.trim().toLowerCase();
  return HANDLE.test(handle) ? handle : null;
}

/**
 * The key a staff reservation is stored and compared by: trimmed, lower-cased, `-` read as `_`,
 * the same folding isReservedHandle applies to the built-in list. So `MTN`, `mtn` and `Mtn` are
 * one reservation, and `how-it-works` is `how_it_works`. Null when the result can't be a handle.
 */
export function reservationKey(raw: string): string | null {
  return normaliseHandle(raw.trim().toLowerCase().replaceAll('-', '_'));
}

export function isReservedHandle(handle: string): boolean {
  return reserved.has(handle.toLowerCase().replaceAll('-', '_'));
}
