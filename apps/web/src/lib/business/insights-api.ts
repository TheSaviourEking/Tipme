'use client';
import { useSyncExternalStore } from 'react';
import {
  BUSINESS_NOTE_TAGS,
  type BusinessNoteTag,
  type BusinessNoteView,
  type LocationInsights,
  type MyMembership,
  type NoteReport,
  type ShownOrHidden,
} from '@tipme/contracts';
import { lagosWeekOf, lagosWeekRange } from '@tipme/domain';
import { apiFetch, type SessionResult } from '@/lib/session-client';

// PR B7: what the business sees, and the person's choice to share their amounts.

const query = (locationId: string, week: string) =>
  new URLSearchParams({ locationId, week }).toString();

export function loadInsights(
  businessId: string,
  locationId: string,
  week: string,
): Promise<SessionResult<LocationInsights>> {
  return apiFetch<LocationInsights>(
    `/v1/me/businesses/${encodeURIComponent(businessId)}/insights?${query(locationId, week)}`,
  );
}

export function loadBusinessNotes(
  businessId: string,
  locationId: string,
  week: string,
): Promise<SessionResult<BusinessNoteView[]>> {
  return apiFetch<BusinessNoteView[]>(
    `/v1/me/businesses/${encodeURIComponent(businessId)}/notes?${query(locationId, week)}`,
  );
}

/** A manager reports a note (B5's route): it disappears from the business until TipMe reviews it. */
export function reportBusinessNote(
  businessId: string,
  noteRef: string,
  reason: NoteReport['reason'],
): Promise<SessionResult<unknown>> {
  return apiFetch(
    `/v1/me/businesses/${encodeURIComponent(businessId)}/notes/${encodeURIComponent(noteRef)}/report`,
    { method: 'POST', body: { reason } },
  );
}

export function saveShareAmounts(
  memberId: string,
  share: boolean,
): Promise<SessionResult<MyMembership>> {
  return apiFetch<MyMembership>(
    `/v1/me/work/${encodeURIComponent(memberId)}/share-amounts`,
    { method: 'PATCH', body: { share } },
  );
}

/** "Fewer than 3" in words, never a number under 3; a withheld count says why. */
export function shownText(shown: ShownOrHidden): string {
  if ('n' in shown) return String(shown.n);
  return 'hidden' in shown
    ? 'Hidden to protect a colleague’s privacy'
    : 'Fewer than 3';
}

export const tagLabel = (tag: BusinessNoteTag): string =>
  BUSINESS_NOTE_TAGS.find((entry) => entry.id === tag)?.label ?? tag;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hourText = (hour: number) => {
  const h = hour % 24;
  return { h: h % 12 === 0 ? 12 : h % 12, pm: h >= 12 };
};
/** "Fri 8–10 pm", "Sat 11 am–1 pm" (day 0 is Sunday, Lagos time). */
export function busiestText(busiest: NonNullable<LocationInsights['busiest']>) {
  const from = hourText(busiest.fromHour);
  const to = hourText(busiest.toHour);
  const fromSuffix = from.pm === to.pm ? '' : from.pm ? ' pm' : ' am';
  return `${DAYS[busiest.day]} ${from.h}${fromSuffix}–${to.h} ${to.pm ? 'pm' : 'am'}`;
}

/** 2026-11-06 → "6 Nov" (the note's Lagos date; never a time). */
export function noteDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

// ---- The week and location the Business page is looking at, shared by This week and Notes.

export const currentWeek = () => lagosWeekOf(new Date());
export function stepWeek(week: string, by: -1 | 1): string {
  const range = lagosWeekRange(week);
  if (!range) return currentWeek();
  return lagosWeekOf(by < 0 ? new Date(range.from.getTime() - 1) : range.to);
}
/** "2–8 Nov 2026": Monday to Sunday in Lagos. */
export function weekText(week: string): string {
  const range = lagosWeekRange(week);
  if (!range) return week;
  // Lagos is UTC+1 all year: an hour after the start is Monday's Lagos midnight in UTC.
  const monday = new Date(range.from.getTime() + 3_600_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const day = (at: Date, withMonth: boolean, withYear: boolean) =>
    new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      ...(withMonth ? { month: 'short' } : {}),
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    }).format(at);
  const sameMonth = monday.getUTCMonth() === sunday.getUTCMonth();
  return `${day(monday, !sameMonth, false)}–${day(sunday, true, true)}`;
}

type View = { businessId: string; locationId: string; week: string } | null;
let view: View = null;
const listeners = new Set<() => void>();
export function setInsightsView(next: View) {
  view = next;
  listeners.forEach((listener) => listener());
}
export function useInsightsView(): View {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => view,
    () => null,
  );
}
