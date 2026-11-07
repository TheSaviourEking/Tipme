/**
 * A business invitation's link: `/dashboard/work#join=<code>` (business PR B3). The code lives in
 * the fragment, so it never reaches a server or a log. A sign-in in between loses the fragment,
 * and a code must never go into `next`, so it is kept in this tab until the Work page uses it
 * (as `ops-client.ts` does for an emailed enrolment link).
 */
export const JOIN_LINK_PREFIX = '#join=';
export const JOIN_LINK_KEY = 'tipme.join-link';

/** The code in a fragment, upper-cased, or null when the fragment isn't a join link. */
export function joinCodeFrom(hash: string): string | null {
  if (!hash.startsWith(JOIN_LINK_PREFIX)) return null;
  const code = hash.slice(JOIN_LINK_PREFIX.length).toUpperCase();
  return /^[A-Z2-7]{16}$/.test(code) ? code : null;
}

/** Before a sign-in redirect: keeps a join link from the address bar in this tab. */
export function keepJoinLink(): void {
  if (!joinCodeFrom(location.hash)) return;
  try {
    sessionStorage.setItem(JOIN_LINK_KEY, location.hash);
  } catch {
    // Storage blocked: the link can simply be opened again once signed in.
  }
}

/** The code from the address bar, or else the one this tab kept through sign-in. */
export function takeJoinCode(): string | null {
  const here = joinCodeFrom(location.hash);
  if (here) return here;
  try {
    return joinCodeFrom(sessionStorage.getItem(JOIN_LINK_KEY) ?? '');
  } catch {
    return null;
  }
}

/** Takes the code out of the address bar and this tab's storage, whatever happened next. */
export function clearJoinLink(): void {
  if (location.hash.startsWith(JOIN_LINK_PREFIX))
    history.replaceState(null, '', location.pathname + location.search);
  try {
    sessionStorage.removeItem(JOIN_LINK_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}
