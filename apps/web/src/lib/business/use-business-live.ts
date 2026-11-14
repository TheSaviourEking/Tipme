'use client';
import { useCallback, useState } from 'react';
import type { LiveEventType } from '@tipme/contracts';
import { useLiveEvents } from '@/components/live/live-provider';

const BUSINESS_CHANGED: readonly LiveEventType[] = ['business.changed'];

/**
 * Plan B9 Task 23: a Business or Work card re-reads when its business changes (a tip, a note, a
 * check-in, an edit by someone else). Each card loads itself on mount, so the stream's first
 * "ready" resync is not used; outside a live provider this does nothing.
 */
export function useBusinessLive(reload: () => void): void {
  useLiveEvents(
    BUSINESS_CHANGED,
    async () => {
      reload();
    },
    { resync: false },
  );
}

/**
 * For a card whose read runs in an effect: a number that goes up on each `business.changed`. Put it
 * in the effect's dependencies only (never in what decides the skeleton), so the new answer
 * replaces the old one without a flash.
 */
export function useBusinessRevision(): number {
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((n) => n + 1), []);
  useBusinessLive(bump);
  return revision;
}
