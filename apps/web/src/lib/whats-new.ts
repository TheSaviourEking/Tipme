import type { WhatsNewEntry, WhatsNewStatus } from '@tipme/contracts';

/**
 * What's new in the dashboard (changelog plan, Task 6.3): the words and groupings the menu dot,
 * the Home slip and the page share. Pure, so they are unit tested without a browser.
 */

/** Dispatched on window after a seen call, so the dot and the slip clear together. */
export const WHATS_NEW_SEEN = 'tipme:whats-new-seen';

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "6 November 2026" for the server's Lagos date (YYYY-MM-DD), the same in every browser zone. */
export function dayLabel(liveOn: string): string {
  return DAY.format(new Date(`${liveOn}T00:00:00Z`));
}

export interface WhatsNewDay {
  liveOn: string;
  label: string;
  entries: WhatsNewEntry[];
}

/** Entries under their day, in the server's order (newest first). */
export function groupByDay(entries: readonly WhatsNewEntry[]): WhatsNewDay[] {
  const days: WhatsNewDay[] = [];
  for (const entry of entries) {
    const last = days.at(-1);
    if (last?.liveOn === entry.liveOn) last.entries.push(entry);
    else
      days.push({
        liveOn: entry.liveOn,
        label: dayLabel(entry.liveOn),
        entries: [entry],
      });
  }
  return days;
}

/** The menu dot. No status (an older API without What's new, or a failed read) means no dot. */
export function hasNewUpdates(status: WhatsNewStatus | null): boolean {
  return (status?.unseen ?? 0) > 0;
}

/** The Home slip's words: the newest unseen line only, or null when there is nothing new. */
export function slipWords(
  status: WhatsNewStatus | null,
): { title: string; line: string; more: string | null } | null {
  if (!status?.newest || status.unseen < 1) return null;
  return {
    title: 'New in TipMe',
    line: status.newest.line,
    more: status.unseen > 1 ? `and ${status.unseen - 1} more` : null,
  };
}

/** What a seen call sends: the instant the newest entry shown went live. */
export function newestLiveAt(entries: readonly WhatsNewEntry[]): string | null {
  return entries[0]?.liveAt ?? null;
}
