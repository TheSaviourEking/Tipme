'use client';
import { useEffect, useState } from 'react';
import type { MyTipDetail, MyTipRow } from '@tipme/contracts';
import { isoWeekRange } from '@/lib/iso-week';
import { apiFetch } from '@/lib/session-client';

export interface WeekNote {
  tipId: string;
  note: string;
  who: string;
  grossMinor: string;
}

const MOST_NOTES = 10;
const MOST_PAGES = 4;

/**
 * The notes supporters left in one week. The report holds only a count, so this reads the
 * recipient's paid tips of that week (newest first, as the list gives them) and then each
 * tip that has a note. A note the recipient hid comes back without its text and is skipped.
 * Reading fails quietly: with no notes, the stack is simply not shown.
 */
export async function loadWeekNotes(week: string): Promise<WeekNote[]> {
  const range = isoWeekRange(week);
  if (!range) return [];
  const withNote: MyTipRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MOST_PAGES; page += 1) {
    const result: Awaited<
      ReturnType<
        typeof apiFetch<{ items: MyTipRow[]; nextCursor: string | null }>
      >
    > = await apiFetch(
      `/v1/me/tips?status=paid${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (!result.ok) break;
    let reachedOlder = false;
    for (const tip of result.data.items) {
      const at = new Date(tip.at).getTime();
      if (at < range.start) reachedOlder = true;
      else if (at < range.end && tip.hasMessage) withNote.push(tip);
    }
    cursor = result.data.nextCursor;
    if (reachedOlder || !cursor || withNote.length >= MOST_NOTES) break;
  }
  const details = await Promise.all(
    withNote.slice(0, MOST_NOTES).map(async (tip) => {
      const result = await apiFetch<MyTipDetail>(
        `/v1/me/tips/${encodeURIComponent(tip.tipId)}`,
      );
      if (!result.ok || !result.data.message || result.data.messageHidden)
        return null;
      return {
        tipId: tip.tipId,
        note: result.data.message,
        who: tip.supporterLabel ?? 'a guest',
        grossMinor: tip.grossMinor,
      };
    }),
  );
  return details.filter((note): note is WeekNote => note !== null);
}

export function useWeekNotes(week: string): WeekNote[] | null {
  const [state, setState] = useState<{
    week: string;
    notes: WeekNote[];
  } | null>(null);
  useEffect(() => {
    let current = true;
    void loadWeekNotes(week).then((notes) => {
      if (current) setState({ week, notes });
    });
    return () => {
      current = false;
    };
  }, [week]);
  return state?.week === week ? state.notes : null;
}
