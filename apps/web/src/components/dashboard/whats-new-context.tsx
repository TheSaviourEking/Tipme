'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { WhatsNewStatus } from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';
import { WHATS_NEW_SEEN } from '@/lib/whats-new';

export interface WhatsNewContextValue {
  /** null until read, after a failed read, or from an older API without What's new: no dot, no slip. */
  status: WhatsNewStatus | null;
  /** Marks What's new seen up to `through` (the newest entry shown), on every device. */
  markSeen: (through: string) => Promise<void>;
}

const nothing: WhatsNewContextValue = {
  status: null,
  markSeen: async () => undefined,
};

export const WhatsNewContext = createContext<WhatsNewContextValue>(nothing);

/** The menu dot, the phone link, the Home slip and the page share one status. */
export function useWhatsNew(): WhatsNewContextValue {
  return useContext(WhatsNewContext);
}

/**
 * The dashboard shell's one loader: read once the profile has loaded (`key` is the person, so a
 * different sign-in reads again), and again after any seen call in this window.
 */
export function useWhatsNewLoader(key: string | null): WhatsNewContextValue {
  const [status, setStatus] = useState<WhatsNewStatus | null>(null);
  const read = useCallback(() => {
    void apiFetch<WhatsNewStatus>('/v1/me/whats-new/status').then((result) =>
      // A 404 is an API from before What's new: the dashboard stays exactly as it was.
      setStatus(result.ok ? result.data : null),
    );
  }, []);
  useEffect(() => {
    if (!key) return;
    read();
    window.addEventListener(WHATS_NEW_SEEN, read);
    return () => window.removeEventListener(WHATS_NEW_SEEN, read);
  }, [key, read]);

  const markSeen = useCallback(
    async (through: string) => {
      // Cleared at once, so the dot and the slip go together; the re-read confirms it.
      setStatus((current) => (current ? { ...current, unseen: 0 } : current));
      const result = await apiFetch('/v1/me/whats-new/seen', {
        method: 'POST',
        body: { through },
      });
      // A failed call (offline, say) puts the dot back: nothing was marked.
      if (result.ok) window.dispatchEvent(new Event(WHATS_NEW_SEEN));
      else read();
    },
    [read],
  );

  return useMemo(() => ({ status, markSeen }), [status, markSeen]);
}
