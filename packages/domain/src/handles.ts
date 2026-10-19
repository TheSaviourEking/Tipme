/**
 * Recipient handles (`/@handle`). Lower-case letters, digits and underscores, 3–30 long, unique
 * without regard to case. Words that would clash with TipMe's own pages are reserved.
 */
const HANDLE = /^[a-z0-9_]{3,30}$/;

export const RESERVED_HANDLES = [
  'about',
  'about_preview',
  'admin',
  'api',
  'dashboard',
  'design_system',
  'dev',
  'for_creators',
  'for_professionals',
  'help',
  'how_it_works',
  'legal',
  'me',
  'mock_checkout',
  'ops',
  'people',
  'preview_states',
  'privacy',
  'recover',
  'root',
  'settings',
  'sign_in',
  'sign_up',
  'signin',
  'signup',
  'staff',
  'support',
  'terms',
  'tip',
  'tipme',
  'tips',
  'verify',
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
