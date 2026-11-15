/**
 * The claim moment ("@handle is yours.") plays once, right after the server confirms a claim.
 * The claim leaves a marker in this tab's session storage; the welcome reads and deletes it. A
 * reload, another tab or another device finds nothing, so it never replays and needs no "seen"
 * record. The marker holds the handle only.
 *
 * It stays until the person moves on (owner, 15 Nov 2026): there is no timer. Continue, Escape,
 * Enter or a tap once the card is down ends it.
 */

/** When the card has landed (the timeline is in globals.css, `.claim-moment`). */
export const CLAIM_LANDED_MS = 550;

/**
 * Taps count only from here: the card is down, plus a short guard. Earlier, a tap is most likely
 * the claim tap itself (or its late click on a phone) landing on the moment, not a choice to move on.
 */
export const CLAIM_TAP_ARMED_MS = CLAIM_LANDED_MS + 250;

export type ClaimMomentInput =
  | { kind: 'key'; key: string; repeat?: boolean }
  | { kind: 'tap'; sinceShownMs: number };

/**
 * Whether this key or tap ends the moment. Escape and Enter do (a held key's repeats do not); Tab
 * and every other key do nothing, so focus moves as usual. A tap does once the card is down.
 */
export function endsClaimMoment(input: ClaimMomentInput): boolean {
  if (input.kind === 'key')
    return !input.repeat && (input.key === 'Escape' || input.key === 'Enter');
  return input.sinceShownMs >= CLAIM_TAP_ARMED_MS;
}

const KEY = 'tipme.claimed';

const sessionStore = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    // Some browsers throw on the getter itself when storage is blocked.
    return undefined;
  }
};

/** Leave the one-time marker for this handle. Never throws. */
export function markClaimed(
  handle: string,
  storage: Pick<Storage, 'setItem'> | undefined = sessionStore(),
): void {
  try {
    storage?.setItem(KEY, handle);
  } catch {
    // Without storage there is simply no moment.
  }
}

/** True once if this handle was just claimed in this tab; the marker is deleted either way. */
export function takeClaimed(
  handle: string,
  storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined = sessionStore(),
): boolean {
  try {
    if (!storage) return false;
    const marked = storage.getItem(KEY);
    if (marked === null) return false;
    storage.removeItem(KEY);
    return marked === handle;
  } catch {
    return false;
  }
}

/** Vibrate about 30 ms where the device allows it; never on reduced motion. Never throws. */
export function claimBuzz(
  nav: Partial<Pick<Navigator, 'vibrate'>> | undefined,
  reducedMotion: boolean,
): void {
  if (reducedMotion || typeof nav?.vibrate !== 'function') return;
  try {
    nav.vibrate(30);
  } catch {
    // Vibration is a nicety; a blocked one changes nothing.
  }
}
