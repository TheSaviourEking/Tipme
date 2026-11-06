'use client';
import { useSyncExternalStore } from 'react';

const subscribe = (changed: () => void) => {
  addEventListener('online', changed);
  addEventListener('offline', changed);
  return () => {
    removeEventListener('online', changed);
    removeEventListener('offline', changed);
  };
};

/** navigator.onLine with the online/offline events; true on the server and before hydration. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
