'use client';
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { dirtyKeys, mergeServerIntoForm } from '@/lib/live-form';

/**
 * Keeps a form in step with its saved value when that changes elsewhere (a live update of the
 * profile): untouched fields follow it, fields being edited keep the person's input, and
 * `changedElsewhere` is set for the "This changed on another device." notice. `showLatest` drops
 * the person's edits for the saved value.
 */
export function useLiveForm<T extends Record<string, unknown>>(
  server: T,
  local: T,
  setLocal: Dispatch<SetStateAction<T>>,
): { changedElsewhere: boolean; showLatest: () => void } {
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const previous = useRef(server);
  const latestLocal = useRef(local);
  useEffect(() => {
    latestLocal.current = local;
  });
  const key = JSON.stringify(server);
  useEffect(() => {
    const before = previous.current;
    previous.current = server;
    if (JSON.stringify(before) === key) return;
    const merged = mergeServerIntoForm({
      server,
      previousServer: before,
      local: latestLocal.current,
      dirty: dirtyKeys(latestLocal.current, before),
    });
    setLocal(merged.next);
    if (merged.changedElsewhere) setChangedElsewhere(true);
    // `key` stands for `server`: a new object with the same values is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    changedElsewhere,
    showLatest: () => {
      setLocal(previous.current);
      setChangedElsewhere(false);
    },
  };
}
