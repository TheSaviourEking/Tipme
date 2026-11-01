'use client';
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './session-client';

// The Pro QR designs are drawn by the API and only shown here. Nothing in this file knows how
// a design looks: it asks for the picture and keeps the last good one while the next loads.

export const artPath = (id: string, size: number) =>
  `/v1/me/qr-art/${id}.png?size=${size}`;
export const artSrc = (id: string, size: number) => apiUrl(artPath(id, size));

/** One design's PNG as a blob, or the API's own plain-words reason it could not be drawn. */
export async function fetchArt(
  id: string,
  size: number,
): Promise<{ blob: Blob } | { error: string }> {
  try {
    const response = await fetch(artSrc(id, size), {
      credentials: 'include',
      cache: 'no-store',
    });
    if (response.ok) return { blob: await response.blob() };
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      error:
        body?.error?.message ?? 'We couldn’t draw this design. Please retry.',
    };
  } catch {
    return { error: 'We couldn’t reach TipMe. Please check your connection.' };
  }
}

/**
 * A design's image URL. The previous image stays in place until the next one has loaded, so the
 * panel never blanks; `version` changes when a new image arrives, to fade it in.
 */
export function useArtImage(id: string | null, size: number) {
  const [state, setState] = useState<{
    url: string | null;
    version: number;
    error: string | null;
  }>({ url: null, version: 0, error: null });
  const current = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void fetchArt(id, size).then((result) => {
      if (!live) return;
      if ('error' in result) {
        setState((old) => ({ ...old, error: result.error }));
        return;
      }
      const url = URL.createObjectURL(result.blob);
      const previous = current.current;
      current.current = url;
      setState((old) => ({ url, version: old.version + 1, error: null }));
      if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000);
    });
    return () => {
      live = false;
    };
  }, [id, size]);
  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );
  return state;
}
