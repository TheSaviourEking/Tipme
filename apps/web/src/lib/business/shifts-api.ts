'use client';
import type { ShiftState } from '@tipme/contracts';
import { LAGOS_TIME_ZONE } from '@tipme/domain';
import { apiFetch, type SessionResult } from '@/lib/session-client';

// PR B6: check in and out. The server decides the shift; these only ask and pass on its answer.

const id = (value: string) => encodeURIComponent(value);

/** The signed-in person, at one of their own memberships. */
export function setOwnShift(
  memberId: string,
  on: boolean,
): Promise<SessionResult<ShiftState>> {
  return apiFetch<ShiftState>(
    `/v1/me/work/${id(memberId)}/shift/${on ? 'start' : 'end'}`,
    { method: 'POST' },
  );
}

/** A manager, for someone at a location they manage. */
export function setMemberShift(
  businessId: string,
  memberId: string,
  on: boolean,
): Promise<SessionResult<ShiftState>> {
  return apiFetch<ShiftState>(
    `/v1/me/businesses/${id(businessId)}/members/${id(memberId)}/shift/${on ? 'start' : 'end'}`,
    { method: 'POST' },
  );
}

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: LAGOS_TIME_ZONE,
});

/** "18:02", Lagos time, as the business keeps its day. */
export const shiftClock = (iso: string) => clock.format(new Date(iso));

/** The words for a refused press. */
export function shiftProblem(result: SessionResult<ShiftState>): string {
  if (result.ok) return '';
  if (result.code === 'BUSINESS_NOT_VERIFIED')
    return 'This business isn’t taking tips on TipMe right now.';
  if (result.status === 404) return 'This place isn’t open on TipMe any more.';
  return 'We couldn’t reach TipMe. Please try again.';
}
