// Business sign-up, Task D4: a login with businesses but no page. Pure: unit tests load it.

/** What a login with no page may open: its business, and what belongs to the login itself. */
const ALLOWED = [
  '/dashboard/business',
  '/dashboard/settings',
  '/dashboard/help',
  '/dashboard/whats-new',
  // Manager invitations are answered here, with no page needed.
  '/dashboard/work',
];

/**
 * null when `pathname` works with no page; otherwise where to go instead (replaced, so Back never
 * returns to a page that can't draw). A page-only address (`/dashboard/tips`, a bookmarked
 * `/dashboard`) opens the business, or Work for a login that so far only has an invitation.
 */
export function accountOnlyRoute(
  pathname: string,
  { manages = true }: { manages?: boolean } = {},
): string | null {
  if (
    ALLOWED.some((base) => pathname === base || pathname.startsWith(`${base}/`))
  )
    return null;
  return manages ? '/dashboard/business' : '/dashboard/work';
}
