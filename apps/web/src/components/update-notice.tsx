'use client';

import { useEffect, useState } from 'react';
import { Button, Surface } from '@tipme/ui';

const CHECK_EVERY_MS = 5 * 60 * 1000;
/** Baked in at build time, the same value `/api/version` answers with. */
const PAGE_VERSION = process.env.TIPME_BUILD_VERSION ?? '';

/**
 * Tells an open page that TipMe has been updated and offers a refresh (owner's request, 3 Nov
 * 2026). It checks when the tab becomes visible again and every 5 minutes while visible, ignores
 * any failed or odd answer, and never reloads by itself: someone may be typing a note.
 */
export function UpdateNotice() {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    // `next dev` has no stable build, and a page without a version has nothing to compare.
    if (process.env.NODE_ENV !== 'production' || !PAGE_VERSION) return;
    let latest: AbortController | undefined;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
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
        if (typeof version === 'string' && version) setServerVersion(version);
      } catch {
        // Offline, aborted or malformed: say nothing.
      }
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
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
