/**
 * 'load': the first read failed, so there is nothing to show. 'refresh': a later read failed
 * after the panel had data; the last data stays on screen and the panel says when it was read.
 */
export type PanelError = 'load' | 'refresh' | null;

export interface PanelState<T> {
  data: T | null;
  error: PanelError;
  /** Browser clock at the last successful read; null before the first. */
  updatedAt: Date | null;
}

/** One read's effect on a panel. A failure never drops what is on screen, or when it was read. */
export function nextPanelState<T>(
  prev: PanelState<T>,
  result: { ok: true; data: T } | { ok: false },
  now: Date,
): PanelState<T> {
  if (result.ok) return { data: result.data, error: null, updatedAt: now };
  return {
    data: prev.data,
    error: prev.updatedAt ? 'refresh' : 'load',
    updatedAt: prev.updatedAt,
  };
}
