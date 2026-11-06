'use client';
import { useSyncExternalStore } from 'react';
import type { BusinessCodes } from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';

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
