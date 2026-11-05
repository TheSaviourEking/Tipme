import type { NotificationView } from '@tipme/contracts';

/**
 * The bell's one polite announcer (spec §7, DECISION-LOG): at most one announcement a minute. A
 * new tip says who and how much, from the notification's own title and body (the recipient's net
 * and the supporter's chosen label, already on screen), or only "You got a new tip" when hidden.
 * More within the minute are held and counted. A tip's note is never read out.
 */
export interface AnnouncerState {
  lastAt: number | null;
  heldCount: number;
}

const MINUTE_MS = 60_000;

const tipCount = (n: number) => `${n} new tip${n === 1 ? '' : 's'}`;

export function announce(
  state: AnnouncerState,
  fresh: readonly NotificationView[],
  now: number,
  o: { hideDetails: boolean },
): { text: string | null; state: AnnouncerState } {
  const tips = fresh.filter((n) => n.kind === 'tip');
  const quiet = state.lastAt !== null && now - state.lastAt < MINUTE_MS;
  if (quiet) {
    // Within the minute: tips are counted for later; other news waits for the panel.
    return {
      text: null,
      state: { ...state, heldCount: state.heldCount + tips.length },
    };
  }
  const count = state.heldCount + tips.length;
  let text: string | null = null;
  if (count > 1 || (count === 1 && state.heldCount === 1))
    text = tipCount(count);
  else if (count === 1) {
    const [only] = tips;
    text = o.hideDetails
      ? 'You got a new tip'
      : `${only!.title} · ${only!.body}`;
  } else if (fresh[0]) text = `${fresh[0].title} · ${fresh[0].body}`;
  if (text === null) return { text, state };
  return { text, state: { lastAt: now, heldCount: 0 } };
}
