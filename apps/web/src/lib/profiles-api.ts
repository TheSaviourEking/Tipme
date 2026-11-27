import { cacheLife, cacheTag } from 'next/cache';
import type { PublicCampaignPage, PublicProfile } from '@tipme/contracts';
import { previewServerKey } from '@tipme/domain';
import { serverApiOrigin } from './server-api-origin.ts';

/** The API as reached from the web server (may differ from the browser's address). */
export const API_ORIGIN = serverApiOrigin({
  // Literal reads: the build inlines NEXT_PUBLIC_API_ORIGIN only where it is named.
  API_INTERNAL_ORIGIN: process.env.API_INTERNAL_ORIGIN,
  NEXT_PUBLIC_API_ORIGIN: process.env.NEXT_PUBLIC_API_ORIGIN,
});

const LOOKUP_TIMEOUT_MS = 4000;

export const profileTag = (handle: string) => `profile:${handle.toLowerCase()}`;

/**
 * A live page's public details, cached until the API reports a change (`/api/revalidate`).
 * "Not available" is cached like any answer; a failure to reach the API is thrown, never cached.
 * An old handle (PR-011) comes back as `{ movedTo }`, the page's current handle.
 */
export async function getPublicProfile(
  handle: string,
): Promise<PublicProfile | { movedTo: string } | null> {
  'use cache';
  // Changes expire the tag at once; this is only the backstop if that signal is ever lost
  // (web briefly down, several web instances): no stale page outlives about half a minute.
  cacheLife({ stale: 30, revalidate: 30, expire: 300 });
  cacheTag(profileTag(handle));
  if (!/^[A-Za-z0-9_]{3,30}$/.test(handle)) return null;
  const password = process.env.PREVIEW_PASSWORD;
  const response = await fetch(
    `${API_ORIGIN}/v1/profiles/${encodeURIComponent(handle)}`,
    {
      redirect: 'manual',
      // A hung API must end in the retry screen, not a page that never finishes.
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      // Staging/preview: the web server proves itself to the API's gate with the server key.
      ...(password
        ? { headers: { 'x-tipme-preview-key': previewServerKey(password) } }
        : {}),
    },
  );
  if (response.status === 404) return null;
  if (response.status === 308) {
    const { data } = (await response.json()) as { data: { movedTo: string } };
    return /^[a-z0-9_]{3,30}$/.test(data.movedTo)
      ? { movedTo: data.movedTo }
      : null;
  }
  if (!response.ok)
    throw new Error(`profile lookup failed: ${response.status}`);
  return ((await response.json()) as { data: PublicProfile }).data;
}

/**
 * For the page itself. Under Partial Prerendering a thrown failure ends in an empty body with no
 * error screen, so a failed lookup comes back as a value the page can render. It isn't cached:
 * only getPublicProfile's answers are.
 */
export async function loadPublicProfile(
  handle: string,
): Promise<Awaited<ReturnType<typeof getPublicProfile>> | 'unreachable'> {
  try {
    return await getPublicProfile(handle);
  } catch (error) {
    console.error('profile lookup failed', error);
    return 'unreachable';
  }
}

const CAMPAIGN_ENDING = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

async function fetchPublicCampaignPage(
  handle: string,
  slug: string,
): Promise<PublicCampaignPage | null> {
  'use cache';
  // The main page's cache rules and tag: a save in Campaign Studio revalidates the profile.
  cacheLife({ stale: 30, revalidate: 30, expire: 300 });
  cacheTag(profileTag(handle));
  const password = process.env.PREVIEW_PASSWORD;
  const response = await fetch(
    `${API_ORIGIN}/v1/profiles/${encodeURIComponent(handle)}/campaigns/${encodeURIComponent(slug)}`,
    {
      redirect: 'manual',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      ...(password
        ? { headers: { 'x-tipme-preview-key': previewServerKey(password) } }
        : {}),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`campaign page lookup failed: ${response.status}`);
  return ((await response.json()) as { data: PublicCampaignPage }).data;
}

/**
 * A campaign's own page (Pro), or null: no page, a stopped or unknown campaign, campaign pages
 * switched off, or any failure. Null always means "show the main page as it is", so a campaign
 * link never breaks because of this lookup. Failures are not cached.
 */
export async function getPublicCampaignPage(
  handle: string,
  slug: string,
): Promise<PublicCampaignPage | null> {
  if (!/^[A-Za-z0-9_]{3,30}$/.test(handle) || !CAMPAIGN_ENDING.test(slug))
    return null;
  try {
    return await fetchPublicCampaignPage(handle, slug);
  } catch (error) {
    console.error('campaign page lookup failed', error);
    return null;
  }
}
