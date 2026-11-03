'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/session-client';

/**
 * 'load': the first read failed, so there is nothing to show. 'refresh': a later read failed
 * after the panel had data; the last data stays on screen and the panel says so quietly.
 */
export type PanelError = 'load' | 'refresh' | null;

export interface Panel<T> {
  data: T | null;
  error: PanelError;
  /** Reads again. A later live stream calls this and nothing else. */
  reload: () => Promise<void>;
}

/** The one place a dashboard panel loads its data. Reads once on mount; never polls. */
export function usePanel<T>(path: string): Panel<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<PanelError>(null);
  const have = useRef(false);
  // An answer for an older path (a search typed over) never replaces a newer one.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    const result = await apiFetch<T>(path);
    if (mine !== latest.current) return;
    if (result.ok) {
      have.current = true;
      setData(result.data);
      setError(null);
    } else setError(have.current ? 'refresh' : 'load');
  }, [path]);
  useEffect(() => {
    const first = setTimeout(() => void reload(), 0);
    return () => clearTimeout(first);
  }, [reload]);
  return { data, error, reload };
}
