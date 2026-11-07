'use client';

/**
 * A note in this browser that someone has signed in here, so the site header can show "Go to my
 * dashboard" instead of "Sign in" without asking the API on every visit. The session cookie lives on
 * the API's own address and can't be read here, so this is only a hint: the API is the truth, and
 * every call to it keeps the hint right (session-client). It holds no name, number or token.
 */
const KEY = 'tipme:signed-in';
export const SIGNED_IN_HINT_CHANGED = 'tipme:signed-in-hint';

export function readSignedInHint(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSignedInHint(signedIn: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (readSignedInHint() === signedIn) return;
    if (signedIn) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked (a private window): the header simply shows Sign in, as before.
    return;
  }
  window.dispatchEvent(new Event(SIGNED_IN_HINT_CHANGED));
}

/**
 * What one API answer says about being signed in: a call to the person's own routes that worked
 * means yes, a 401 there or a finished sign-out means no, anything else says nothing.
 */
export function hintFromAnswer(
  path: string,
  status: number,
): boolean | undefined {
  const worked = status >= 200 && status < 300;
  if (path.startsWith('/v1/auth/sign-out')) return worked ? false : undefined;
  // Only the signed-in person's own routes: an admin route's 401 is about the admin grant.
  if (!path.startsWith('/v1/me/')) return undefined;
  if (status === 401) return false;
  return worked ? true : undefined;
}
