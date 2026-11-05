'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEventType } from '@tipme/contracts';
import { useLiveEvents } from '@/components/live/live-provider';
import { apiFetch } from '@/lib/session-client';
import {
  nextPanelState,
  type PanelError,
  type PanelState,
} from './panel-state';

export type { PanelError };

export interface Panel<T> {
  data: T | null;
  error: PanelError;
  /** Reads again: what a live signal, a resync and the fallback poll call. */
  reload: () => Promise<void>;
  /** Browser clock at the last successful read; null before the first. */
  updatedAt: Date | null;
}

const NONE: readonly LiveEventType[] = [];

/**
 * The one place a dashboard panel loads its data. Reads once on mount, then again on the live
 * signals in `options.live` (and every resync), never on a timer of its own.
 */
export function usePanel<T>(
  path: string,
  /** `resync: false`: not re-read on a resync either (a list someone is reading deep into). */
  options?: { live?: readonly LiveEventType[]; resync?: boolean },
): Panel<T> {
  const [state, setState] = useState<PanelState<T>>({
    data: null,
    error: null,
    updatedAt: null,
  });
  // An answer for an older path (a search typed over), or an older read, never replaces a newer one.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    const result = await apiFetch<T>(path);
    if (mine !== latest.current) return;
    setState((prev) => nextPanelState(prev, result, new Date()));
  }, [path]);
  useEffect(() => {
    const first = setTimeout(() => void reload(), 0);
    return () => clearTimeout(first);
  }, [reload]);
  useLiveEvents(options?.live ?? NONE, reload, {
    resync: options?.resync ?? true,
  });
  return { ...state, reload };
}
