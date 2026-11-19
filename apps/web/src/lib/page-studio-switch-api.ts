import { connection } from 'next/server';
import { pageStudioOn } from './page-studio-switch';
import { API_ORIGIN } from './profiles-api';

/**
 * Asks the API whether Page Studio is on, at request time (never at build, where there is no API).
 * Not cached: only the editor's preview frame asks, once per editor open, and a switch turned off
 * closes it at once. A failed read is off.
 */
export async function getPageStudioOn(): Promise<boolean> {
  await connection();
  try {
    const response = await fetch(`${API_ORIGIN}/health/release`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    return pageStudioOn(((await response.json()) as { data?: unknown }).data);
  } catch {
    return false;
  }
}
