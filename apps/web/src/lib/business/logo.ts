'use client';
import { useEffect, useState } from 'react';
import type { BusinessDetail } from '@tipme/contracts';
import { apiFetch, apiUrl } from '@/lib/session-client';

// A business's logo in the dashboard and ops (6 Nov 2026). The public address works only once the
// business is verified, so signed-in screens read it from their own private route instead, like
// the cover preview in Settings, and show it from a blob.

const base = (businessId: string) =>
  `/v1/me/businesses/${encodeURIComponent(businessId)}/logo`;

export const uploadBusinessLogo = (businessId: string, file: Blob) =>
  apiFetch<BusinessDetail>(base(businessId), { method: 'PUT', file });

export const removeBusinessLogo = (businessId: string) =>
  apiFetch<BusinessDetail>(base(businessId), { method: 'DELETE' });

/**
 * The logo at `path` (a manager's route, or the ops one) as a blob URL. `key` changes with each
 * new logo (its public path), so a new upload is read again; null `key` means there is none.
 */
export function usePrivateLogo(path: string, key: string | null | undefined) {
  const [loaded, setLoaded] = useState<{
    key: string;
    url: string | null;
  } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const response = await fetch(apiUrl(path), {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('no logo');
        url = URL.createObjectURL(await response.blob());
        if (cancelled) URL.revokeObjectURL(url);
        else setLoaded({ key, url });
      } catch {
        if (!cancelled) setLoaded({ key, url: null });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, key]);
  return key && loaded?.key === key ? loaded.url : null;
}

/** A manager's view of their business's logo (any status). */
export const useManagedLogo = (business: BusinessDetail | null) =>
  usePrivateLogo(business ? base(business.id) : '', business?.logoPath);
