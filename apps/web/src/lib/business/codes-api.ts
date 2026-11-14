'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { BusinessCodes } from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';
import { API_ORIGIN, businessLogoSource } from '@/lib/avatar-source';
import { loadSignLogo, type SignLogo } from '@/lib/business-sign';

/** Lane B8's web calls: the signs and badges a manager may print. */
export type CodesAnswer =
  | { state: 'ready'; codes: BusinessCodes }
  | { state: 'not-verified' }
  | { state: 'failed' };

export async function loadBusinessCodes(
  businessId: string,
): Promise<CodesAnswer> {
  const result = await apiFetch<BusinessCodes>(
    `/v1/me/businesses/${encodeURIComponent(businessId)}/codes`,
  );
  if (result.ok) return { state: 'ready', codes: result.data };
  if (result.code === 'BUSINESS_NOT_VERIFIED') return { state: 'not-verified' };
  return { state: 'failed' };
}

const neverChanges = () => () => undefined;

/** This copy of TipMe's origin, as `/dashboard/qr` uses: empty while rendering on the server. */
export function useWebOrigin(): string {
  return useSyncExternalStore(
    neverChanges,
    () => location.origin,
    () => '',
  );
}

/** Saves a drawn canvas as a PNG, as the QR studio's download does. */
export async function downloadCanvas(
  canvas: HTMLCanvasElement,
  filename: string,
): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// One load per logo for the page's life: the previews, the download and the print share it.
const logos = new Map<string, Promise<SignLogo | null>>();

/**
 * A business's logo, loaded for a sign, or null when it has none or it failed to load (the tile
 * then shows the initial). Only the API's public logo address is used.
 */
export function signLogo(
  logoPath: string | undefined,
): Promise<SignLogo | null> {
  const src = businessLogoSource(logoPath, API_ORIGIN);
  if (!src) return Promise.resolve(null);
  let loading = logos.get(src);
  if (!loading) {
    loading = loadSignLogo(src);
    logos.set(src, loading);
  }
  return loading;
}

/**
 * The logo for drawing: `undefined` while it loads (draw nothing yet, so the initial never flashes
 * before the logo), then the logo or null.
 */
export function useSignLogo(
  logoPath: string | undefined,
): SignLogo | null | undefined {
  const [loaded, setLoaded] = useState<{
    path: string | undefined;
    logo: SignLogo | null;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void signLogo(logoPath).then((logo) => {
      if (current) setLoaded({ path: logoPath, logo });
    });
    return () => {
      current = false;
    };
  }, [logoPath]);
  return loaded && loaded.path === logoPath ? loaded.logo : undefined;
}
