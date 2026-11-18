import {
  CLAIM_LINK_CODE,
  CLAIM_LINK_PREFIX,
  type ClaimLinkPreview,
} from '@tipme/contracts';

/**
 * A username claim link: `/sign-up/claim#claim=<code>` (handover, owner's approval 18 Nov 2026).
 * The code lives in the fragment, so it never reaches a server, a log or analytics. The page takes
 * it out of the address bar at once and keeps it in this tab only, so a reload or a sign-in keeps
 * it, and it never goes into a `next` link. It travels to the API only in a request body.
 */
export const CLAIM_LINK_KEY = 'tipme.claim-link';

/** The code in a fragment, upper-cased, or null when the fragment isn't a claim link. */
export function claimCodeFrom(hash: string): string | null {
  if (!hash.startsWith(CLAIM_LINK_PREFIX)) return null;
  const code = hash.slice(CLAIM_LINK_PREFIX.length).toUpperCase();
  return CLAIM_LINK_CODE.test(code) ? code : null;
}

function stored(): string | null {
  try {
    return claimCodeFrom(
      `${CLAIM_LINK_PREFIX}${sessionStorage.getItem(CLAIM_LINK_KEY) ?? ''}`,
    );
  } catch {
    return null;
  }
}

/**
 * The code from the address bar (moved into this tab's storage and out of the address bar), or
 * else the one this tab kept.
 */
export function takeClaimCode(): string | null {
  // A link in the address bar wins over one kept earlier, even a broken one.
  if (!location.hash.startsWith(CLAIM_LINK_PREFIX)) return stored();
  const here = claimCodeFrom(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  if (!here) {
    clearClaimLink();
    return null;
  }
  try {
    sessionStorage.setItem(CLAIM_LINK_KEY, here);
  } catch {
    // Storage blocked: the link works now; opening it again works later.
  }
  return here;
}

/** Forgets the code, whatever happened: claimed, or a link that no longer works. */
export function clearClaimLink(): void {
  try {
    sessionStorage.removeItem(CLAIM_LINK_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/** The whole link staff copy: this web app's origin and the path the API gave. */
export const claimLinkUrl = (origin: string, path: string): string =>
  `${origin}${path}`;

/** A link that doesn't work, in plain words. */
export function claimPreviewWords(
  state: Exclude<ClaimLinkPreview['state'], 'open'>,
): { title: string; text: string } {
  switch (state) {
    case 'used':
      return {
        title: 'This link has been used',
        text: 'Someone has already claimed the username with it, and a link works only once. If that wasn’t you, contact the TipMe team.',
      };
    case 'expired':
      return {
        title: 'This link has expired',
        text: 'A claim link works for 14 days. Ask the TipMe team member who sent it for a new one.',
      };
    case 'cancelled':
      return {
        title: 'This link no longer works',
        text: 'The TipMe team stopped it, or sent a newer one. Use the newest link you were sent, or ask for a new one.',
      };
    case 'invalid':
      return {
        title: 'We don’t recognise this link',
        text: 'Check that you copied the whole link, or ask the TipMe team member who sent it.',
      };
  }
}

/** Why a claim was refused, in plain words (a link that isn't open is shown by its preview). */
export function claimRefusalWords(code: string, status: number): string {
  if (status === 429)
    return 'There have been a lot of tries from here. Wait an hour, then try again.';
  switch (code) {
    case 'HANDOVER_STAFF_ACCOUNT':
      return 'You’re signed in with a TipMe staff account, and staff accounts can’t receive a username this way. Sign in with the account that should have it.';
    case 'HANDOVER_ACCOUNT_CHANGED':
      return 'Your account changed while this was happening. Nothing was claimed; try again.';
    case 'HANDOVER_ACCOUNT_UNAVAILABLE':
      return 'Your account can’t take this username right now. Contact the TipMe team and they’ll sort it out with you.';
    default:
      return 'We couldn’t claim it. Please try again.';
  }
}
