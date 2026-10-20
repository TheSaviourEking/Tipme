import { cacheLife, cacheTag } from 'next/cache';
import type { PublicProfile } from '@tipme/contracts';
import { previewServerKey } from '@tipme/domain';

/** The API as reached from the web server (may differ from the browser's address). */
const API_ORIGIN =
  process.env.API_INTERNAL_ORIGIN ??
  process.env.NEXT_PUBLIC_API_ORIGIN ??
  'http://localhost:4000';

export const profileTag = (handle: string) => `profile:${handle.toLowerCase()}`;

/**
 * A live page's public details, cached until the API reports a change (`/api/revalidate`).
 * "Not available" is cached like any answer; a failure to reach the API is thrown, never cached.
 */
export async function getPublicProfile(
  handle: string,
): Promise<PublicProfile | null> {
  'use cache';
  // Changes expire the tag at once; this is only the backstop if that signal is ever lost
  // (web briefly down, several web instances): no stale page outlives about half a minute.
  cacheLife({ stale: 30, revalidate: 30, expire: 300 });
  cacheTag(profileTag(handle));
  if (!/^[A-Za-z0-9_]{3,30}$/.test(handle)) return null;
  const password = process.env.PREVIEW_PASSWORD;
  const response = await fetch(
    `${API_ORIGIN}/v1/profiles/${encodeURIComponent(handle)}`,
    // Staging/preview: the web server proves itself to the API's gate with the server key.
    password
      ? { headers: { 'x-tipme-preview-key': previewServerKey(password) } }
      : undefined,
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`profile lookup failed: ${response.status}`);
  return ((await response.json()) as { data: PublicProfile }).data;
}
