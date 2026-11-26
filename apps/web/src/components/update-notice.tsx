'use client';

import { useEffect, useState } from 'react';
import { Button, Surface } from '@tipme/ui';
import { livePresence } from '@/lib/live-presence';
import { readyMayCheck, updateCheckEveryMs } from '@/lib/update-check';

/** Baked in at build time, the same value `/api/version` answers with. */
const PAGE_VERSION = process.env.TIPME_BUILD_VERSION ?? '';

/**
 * Tells an open page that TipMe has been updated and offers a refresh (owner's request, 3 Nov
 * 2026). It checks when the tab becomes visible again, in every mode. Otherwise it follows the
 * page's live streams (addendum §3.5): with a connected stream it checks on each stream `ready`
 * (at most once a minute) and runs no timer; with a live provider but no connected stream, every
 * 5 minutes; with no live provider, every 30 minutes. It ignores any failed or odd answer, and
 * never reloads by itself: someone may be typing a note.
 */
export function UpdateNotice() {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    // `next dev` has no stable build, and a page without a version has nothing to compare.
    if (process.env.NODE_ENV !== 'production' || !PAGE_VERSION) return;
    let cancelled = false;
    let latest: AbortController | undefined;
    let lastCheckAt: number | null = null;
    const check = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      lastCheckAt = performance.now();
      latest?.abort();
      const controller = (latest = new AbortController());
      try {
        const response = await fetch('/api/version', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body: unknown = await response.json();
        const version =
          typeof body === 'object' && body !== null && 'version' in body
            ? body.version
            : null;
        if (cancelled) return;
        if (typeof version === 'string' && version) setServerVersion(version);
      } catch {
        // Offline, aborted or malformed: say nothing.
      }
    };
    const checkNow = () => void check();

    // Re-armed only when the period changes: a stream flapping between connecting and polling
    // reports many statuses, and restarting the 5-minute interval on each would starve it.
    let timer: number | undefined;
    let everyMs: number | null | undefined;
    const arm = () => {
      const next = updateCheckEveryMs(livePresence.snapshot());
      if (next === everyMs) return;
      everyMs = next;
      window.clearInterval(timer);
      timer = next === null ? undefined : window.setInterval(checkNow, next);
    };
    const off = livePresence.subscribe((event) => {
      if (cancelled) return;
      if (event === 'status') arm();
      else if (readyMayCheck(lastCheckAt, performance.now())) void check();
    });
    arm();
    document.addEventListener('visibilitychange', checkNow);
    return () => {
      cancelled = true;
      off();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', checkNow);
      latest?.abort();
    };
  }, []);

  const updated =
    serverVersion !== null &&
    serverVersion !== PAGE_VERSION &&
    serverVersion !== dismissed;

  if (!updated) return null;
  // role="status" is announced politely; it is added only when there is news, so pages that look
  // for their own status message find just one.
  return (
    <div className="update-notice" role="status">
      <Surface material="instrument" className="update-notice__card">
        <p className="update-notice__text">TipMe has been updated.</p>
        <div className="update-notice__actions">
          <Button variant="continue" onClick={() => window.location.reload()}>
            Refresh
          </Button>
          <Button variant="quiet" onClick={() => setDismissed(serverVersion)}>
            Later
          </Button>
        </div>
      </Surface>
    </div>
  );
}
