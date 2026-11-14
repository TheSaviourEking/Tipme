import type { SignInVerified } from '@tipme/contracts';

// Business sign-up, Task D1: where a sign-in lands. Pure, so the table test can run it.

const startsWithPath = (next: string, base: string) =>
  next === base ||
  next.startsWith(`${base}/`) ||
  next.startsWith(`${base}?`) ||
  next.startsWith(`${base}#`);

/**
 * A page → where they were going. The admin area never needs a page. No page but a business
 * (`managesBusiness`, only ever true with BUSINESS_SIGNUP_ENABLED) → the business, or where they
 * were going if that is the business or its statements. Anyone else chooses a handle.
 */
export function signedInLanding(
  result: Pick<SignInVerified, 'hasProfile'> &
    Partial<Pick<SignInVerified, 'managesBusiness'>>,
  next: string,
): string {
  if (result.hasProfile) return next;
  if (startsWithPath(next, '/ops')) return next;
  if (result.managesBusiness === true)
    return startsWithPath(next, '/dashboard/business') ||
      startsWithPath(next, '/statements')
      ? next
      : '/dashboard/business';
  return '/sign-up';
}
