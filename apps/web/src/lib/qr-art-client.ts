'use client';
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './session-client';

// The Pro QR designs are drawn by the API and only shown here. Nothing in this file knows how
// a design looks: it asks for the picture and keeps the last good one while the next loads.

export const artPath = (id: string, size: number) =>
  `/v1/me/qr-art/${id}.png?size=${size}`;
export const artSrc = (path: string) => apiUrl(path);

export type ArtResult =
  | {
      blob: Blob;
      /** The API drew a marked preview, whatever this page last believed about its plan. */
      preview: boolean;
    }
  | { error: string; code: string };

/** One design's PNG as a blob, or the API's own plain-words reason it could not be drawn. */
export async function fetchArt(id: string, size: number): Promise<ArtResult> {
  try {
    const response = await fetch(artSrc(artPath(id, size)), {
      credentials: 'include',
      cache: 'no-store',
    });
    if (response.ok)
      return {
        blob: await response.blob(),
        preview: response.headers.get('x-qr-preview') === '1',
      };
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    return {
      error:
        body?.error?.message ?? 'We couldn’t draw this design. Please retry.',
      code: body?.error?.code ?? 'INTERNAL_ERROR',
    };
  } catch {
    return {
      error: 'We couldn’t reach TipMe. Please check your connection.',
      code: 'NETWORK',
    };
  }
}

interface ArtState {
  /** The design the picture and the error belong to. */
  id: string | null;
  url: string | null;
  /** The picture before this one, kept under it while the new one fades in. */
  previous: string | null;
  version: number;
  preview: boolean;
  error: { id: string; message: string; code: string } | null;
}

/**
 * A design's image. The previous picture stays in place until the next has loaded, so the panel
 * never blanks. Everything is tagged with the design it belongs to: a picture or an error is only
 * shown for its own design.
 */
/** `refresh`: drawn again when it changes (the plan, so a page that turns Pro loses the watermark). */
export function useArtImage(id: string | null, size: number, refresh?: string) {
  const [state, setState] = useState<ArtState>({
    id: null,
    url: null,
    previous: null,
    version: 0,
    preview: false,
    error: null,
  });
  const current = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void fetchArt(id, size).then((result) => {
      if (!live) return;
      if ('error' in result) {
        setState((old) => ({
          ...old,
          error: { id, message: result.error, code: result.code },
        }));
        return;
      }
      const url = URL.createObjectURL(result.blob);
      const previous = current.current;
      current.current = url;
      setState((old) => ({
        id,
        url,
        previous: result.preview ? null : old.url,
        version: old.version + 1,
        preview: result.preview,
        error: null,
      }));
      if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000);
    });
    return () => {
      live = false;
    };
  }, [id, size, refresh]);
  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );
  const clearPrevious = () =>
    setState((old) => (old.previous ? { ...old, previous: null } : old));
  return {
    ...state,
    error: state.error && state.error.id === id ? state.error : null,
    /** True when the picture on hand is this design's. */
    ready: state.id === id && state.url !== null,
    clearPrevious,
  };
}
