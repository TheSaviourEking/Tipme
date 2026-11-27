import { connection } from 'next/server';
import {
  createDisplaySettingsReader,
  type DisplaySettings,
} from './display-settings.ts';
import { serverApiOrigin } from './server-api-origin.ts';

const API_ORIGIN = serverApiOrigin({
  // Literal reads: the build inlines NEXT_PUBLIC_API_ORIGIN only where it is named.
  API_INTERNAL_ORIGIN: process.env.API_INTERNAL_ORIGIN,
  NEXT_PUBLIC_API_ORIGIN: process.env.NEXT_PUBLIC_API_ORIGIN,
});

/** One reader per web instance: the proxy and the pages share it. */
export const readDisplaySettings = createDisplaySettingsReader({
  read: async () => {
    const response = await fetch(`${API_ORIGIN}/health/release`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok)
      throw new Error(`release lookup failed: ${response.status}`);
    return ((await response.json()) as { data?: unknown }).data;
  },
  now: Date.now,
});

/** For pages: read at request time only, never at build (there is no API to ask then). */
export async function getDisplaySettings(): Promise<DisplaySettings | null> {
  await connection();
  return readDisplaySettings();
}
