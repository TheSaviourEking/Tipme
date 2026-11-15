'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEventType } from '@tipme/contracts';
import {
  useFirstReadPhase,
  useLiveEvents,
} from '@/components/live/live-provider';
import {
  createFirstRead,
  FIRST_READ_CAP_MS,
  type FirstRead,
} from '@/lib/first-read';
import { readPanel } from '@/lib/panel-read';
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
  /**
   * The HTTP status of the last read when it failed (0: no answer), else null. Lets a panel tell
   * "there is nothing here yet" (404) from a failure, which only the failure calls an error.
   */
  failedStatus: number | null;
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
  const [failedStatus, setFailedStatus] = useState<number | null>(null);
  const first = useRef<FirstRead | null>(null);
  const reload = useCallback(async () => {
    first.current?.started();
    const mine = ++latest.current;
    // Always settles (a time limit, panel-read.ts), so a first read that never answers still ends
    // in the load error, with Try again, instead of an endless skeleton.
    const result = await readPanel<T>(path);
    if (mine !== latest.current) return;
    setState((prev) => nextPanelState(prev, result, new Date()));
    setFailedStatus(result.ok ? null : result.status);
  }, [path]);
  // The first read (again for each new path). While the stream connects it waits for the ready
  // resync, so a load reads each panel once (first-read.ts).
  useEffect(() => {
    const controller = createFirstRead({
      capMs: FIRST_READ_CAP_MS,
      read: () => void reload(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (timer) => window.clearTimeout(timer as number),
    });
    first.current = controller;
    return () => controller.dispose();
  }, [reload]);
  const resync = options?.resync ?? true;
  // A panel the ready resync won't read must not wait for it.
  const livePhase = useFirstReadPhase();
  const phase = resync ? livePhase : 'free';
  useEffect(() => {
    first.current?.update(phase);
  }, [phase, reload]);
  useLiveEvents(options?.live ?? NONE, reload, { resync });
  return { ...state, failedStatus, reload };
}
