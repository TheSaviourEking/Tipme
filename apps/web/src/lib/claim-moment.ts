/**
 * The claim moment ("@handle is yours.") plays once, right after the server confirms a claim.
 * The claim leaves a marker in this tab's session storage; the welcome reads and deletes it. A
 * reload, another tab or another device finds nothing, so it never replays and needs no "seen"
 * record. The marker holds the handle only.
 */
export const CLAIM_MOMENT_MS = 1600;

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
