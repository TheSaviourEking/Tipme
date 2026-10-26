'use client';
import { useSyncExternalStore } from 'react';

const neverChanges = () => () => {};

/**
 * The host people actually reach this copy of TipMe on (staging, production or local), for
 * showing someone their link. Empty during server rendering, then filled in the browser.
 */
export function useSiteHost(): string {
  return useSyncExternalStore(
    neverChanges,
    () => location.host,
    () => '',
  );
}
